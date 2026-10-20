#include <stdio.h>
int main(){
    int han;
    scanf("%d",&han);
    if(han<0||han>100){
        printf("Score is error!");
        return 0;
    }
    if(han>=90){
        printf("A");
    }
    else if(han>=80){
        printf("B");
    }
    else if(han>=70){
        printf("C");
    }
    else if(han>=60){
        printf("D");
    }
    else{
        printf("E");
    }
    return 0;
}
